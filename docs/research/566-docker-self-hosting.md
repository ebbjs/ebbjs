# Docker self-hosting for `ebb_server` (#566): base images, runtime deps, release semantics

Research note for [issue #566](https://github.com/ebbjs/ebbjs/issues/566). Written
2026-10-23 against `main` @ `13651ef`. Docker is not usable in this environment
(no daemon socket, no podman), so **every image fact below was fetched from the
Docker Hub registry API over HTTP and inspected from the downloaded layers**, and
every "does the release do X" claim was checked against the release already in
`ebb_server/_build/prod/rel/ebb_server` or a throwaway project in `/tmp`.

**Recommendation in one block.**

```dockerfile
# build stage — compiles OTP NIFs against bookworm/glibc 2.36 + OpenSSL 3
FROM elixir:1.17.3-otp-27@sha256:ceab9a0a37f0d8b5d405efe0eb4c8575477864c2fcff017e949dbaf9b46d741b AS build

# runtime stage — same distro family, no toolchain
FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8
RUN apt-get update && apt-get install -y --no-install-recommends \
      libsnappy1v5 libssl3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# runtime-only apt cost: ~2.0 MiB download (libssl3+libsnappy1v5)
#                        ~2.1 MiB more with ca-certificates for outbound TLS
```

`liblz4-1`, `libstdc++6`, `libgcc-s1`, `libtinfo6`, `zlib1g`, `libzstd1`,
`libbz2-1.0` are **already in `debian:bookworm-slim`** — do not list them.

---

## 1. Base images and pinned digests (`linux/amd64`)

Token + manifest fetch (the same shape for `debian`):

```console
$ TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/elixir:pull" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
$ curl -s -D hdr -o idx.json -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" \
    https://registry-1.docker.io/v2/library/elixir/manifests/1.17.3-otp-27
$ grep -i 'content-type\|docker-content-digest' hdr
content-type: application/vnd.oci.image.index.v1+json
docker-content-digest: sha256:ceab9a0a37f0d8b5d405efe0eb4c8575477864c2fcff017e949dbaf9b46d741b
```

`elixir:1.17-otp-27` was fetched the same way and returned the **same**
`docker-content-digest` (`sha256:ceab9a0a…d741b`) — the floating tag and the
pinned 1.17.3 tag are the same image today. Note the amd64 manifest for
`1.17-otp-27` is also `sha256:b3f52c1c…95f8b`, i.e. identical.

| image                  | index (multi-arch) digest                                                 | amd64 manifest digest                                                     | amd64 config digest                                                       |
| ---------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `elixir:1.17.3-otp-27` | `sha256:ceab9a0a37f0d8b5d405efe0eb4c8575477864c2fcff017e949dbaf9b46d741b` | `sha256:b3f52c1c39a0f36933a9d2217f5bde7906a63c445f5b9a8724b3dc07a8195f8b` | `sha256:6526cc35f46ecf66ffd6ff7c4e05fab5496ff5454131cf1deec28ad6bda6ac9f` |
| `debian:bookworm-slim` | `sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8` | `sha256:ec31d744f83f4a73447ba045aaab9409997efe5cc706eca4890c1be36cc1606a` | `sha256:8da84df25d28176be84164040cd45e128c6b4c6a80b7d7cbe17fe2b9f198efc2` |

Both index digests re-resolved with `HTTP 200` when requested directly as
manifests, so they are valid `FROM` pins:

```console
$ curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.oci.image.index.v1+json, ..." \
    https://registry-1.docker.io/v2/library/elixir/manifests/sha256:ceab9a0a37f0d8b5d405efe0eb4c8575477864c2fcff017e949dbaf9b46d741b
200
$ ... https://registry-1.docker.io/v2/library/debian/manifests/sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8
200
```

Exact strings to use:

```
FROM elixir:1.17.3-otp-27@sha256:ceab9a0a37f0d8b5d405efe0eb4c8575477864c2fcff017e949dbaf9b46d741b AS build
FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8
```

Index digest + tag is the right pin: Docker resolves the index per build platform,
so an `arm64` build keeps working. Pinning `@sha256:b3f52c1c…` (the amd64
manifest) instead would make an `--platform=linux/arm64` build fail. Tags move —
`elixir:1.17.3-otp-27` was built `2026-10-21T04:14:16Z` and
`debian:bookworm-slim` `2026-10-20T21:32:55Z`, both after the pins in this note
were taken, so re-pin on each Dockerfile bump.

## 2. What distro / OpenSSL does the builder image use?

Config blob (`registry-1.docker.io/v2/library/elixir/blobs/sha256:6526cc35…`):

```console
$ python3 -c "import json;d=json.load(open('cfg.json'));print(d['created']);[print(' ',e) for e in d['config']['Env']]"
2026-10-21T04:14:16.522468788Z
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  OTP_VERSION=27.3.4.19
  REBAR3_VERSION=3.27.0
  REBAR_VERSION=2.6.4
  ELIXIR_VERSION=v1.17.3
  LANG=C.UTF-8
```

Layers were downloaded and merged in manifest order into one rootfs (no `.wh.`
whiteouts in any of the 8 layers), then read:

```console
$ for f in layers...; do tar xzf $f -C root; done
$ cat root/etc/os-release
PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
VERSION_ID="12"
VERSION_CODENAME=bookworm
$ ls -l root/usr/lib/x86_64-linux-gnu/ | grep -E 'libcrypto|libssl'
lrwxrwxrwx libcrypto.so -> libcrypto.so.3
-rw-r--r-- libcrypto.so.3          4742424
lrwxrwxrwx libssl.so -> libssl.so.3
-rw-r--r-- libssl.so.3             688160
$ awk '$1=="Package:"&&$2=="libssl3"{f=1} f&&$1=="Version:"{print $2;exit}' root/var/lib/dpkg/status
3.0.22-1~deb12u1
$ readelf -d root/usr/local/lib/erlang/lib/crypto-*/priv/lib/crypto.so | grep NEEDED
 (NEEDED) Shared library: [libcrypto.so.3]
 (NEEDED) Shared library: [libc.so.6]
$ ls -d root/usr/local/lib/erlang/erts-*
/usr/local/lib/erlang/erts-15.2.7.14
$ cat root/usr/local/lib/erlang/releases/*/OTP_VERSION
27.3.4.19
```

Conclusions:

- **Debian 12 (bookworm), OpenSSL 3.0.x** (`libssl3 3.0.22-1~deb12u1`).
  `libcrypto.so.3` is present and `libcrypto.so.1.1` is absent from the merged
  rootfs (bookworm ships OpenSSL 3 only; `libssl1.1` was bullseye).
- The image's own ERTS (`erts-15.2.7.14`, OTP 27.3.4.19) was compiled against
  `libcrypto.so.3`, so a release assembled inside this image links OpenSSL 3 and
  a `debian:bookworm-slim` runtime (also `libssl3`, `3.0.20-1~deb12u2` in the
  archive today) loads it. Same major, no ABI gap.
- The image already contains `curl`, `ca-certificates`, `git`, `build-essential`
  (`buildpack-deps:bookworm` + the OTP build layer), so the build stage needs no
  extra HTTP tooling.
- Local `.tool-versions` pins `erlang 27.0` → ERTS **15.0**, while the image is
  ERTS **15.2.7.14**. Do not mix them; see the glibc risk in §6.

## 3. Runtime shared-library requirements of the built release

`ldd` on this Ubuntu 24.04 host resolves paths, so the soname list below comes
from the ELFs themselves (`readelf -d … NEEDED`); `ldd` was cross-checked on the
same files and reported the same sonames.

```console
$ cd ebb_server/_build/prod/rel/ebb_server
$ for f in erts-15.0/bin/beam.smp lib/*/priv/*.so lib/*/priv/lib/*.so; do
    file "$f" | grep -q ELF && { echo "--- $f"; readelf -d "$f" | grep NEEDED; }; done
--- erts-15.0/bin/beam.smp
  NEEDED libtinfo.so.6, libstdc++.so.6, libm.so.6, libgcc_s.so.1, libc.so.6
--- lib/asn1-5.3/priv/lib/asn1rt_nif.so         NEEDED libc.so.6
--- lib/crypto-5.5/priv/lib/crypto.so           NEEDED libcrypto.so.3, libc.so.6
--- lib/crypto-5.5/priv/lib/crypto_callback.so  NEEDED libc.so.6
--- lib/crypto-5.5/priv/lib/otp_test_engine.so  NEEDED libcrypto.so.3, libc.so.6
--- lib/exqlite-0.35.0/priv/sqlite3_nif.so      NEEDED libc.so.6
--- lib/rocksdb-2.5.0/priv/liberocksdb.so
  NEEDED liblz4.so.1, libsnappy.so.1, libstdc++.so.6, libm.so.6,
         libgcc_s.so.1, libc.so.6, ld-linux-x86-64.so.2
--- lib/runtime_tools-2.1/priv/lib/trace_file_drv.so, trace_ip_drv.so  NEEDED libc.so.6
$ ldd lib/rocksdb-2.5.0/priv/liberocksdb.so    # same set, resolved
$ readelf -d ebb_server/deps/rocksdb/priv/liberocksdb.so | grep NEEDED  # identical to the copy in the release
```

(Other `erts-15.0/bin/*` helpers — `epmd`, `erlexec`, `erl_child_setup`,
`inet_gethost`, `escript`, `heart`, `run_erl`, `to_erl`, `yielding_c_fun`, … —
need only `libc.so.6` plus `libm.so.6`.)

Distinct NEEDED set: `libc.so.6`, `libm.so.6`, `libgcc_s.so.1`,
`libstdc++.so.6`, `libtinfo.so.6`, `libcrypto.so.3`, `liblz4.so.1`,
`libsnappy.so.1`, `ld-linux-x86-64.so.2`.

**Not** required: `libncursesw6` (only `libtinfo6` is linked), `libsqlite3`
(exqlite bundles SQLite into `sqlite3_nif.so`), `libssl.so.3` (nothing links it;
`libcrypto.so.3` comes from the same package), `libz`/`libbz2`/`libzstd`
(this `liberocksdb.so` has them statically linked).

Mapping to Debian 12 packages, and whether `debian:bookworm-slim` already has
them. "Already in slim" was verified from the image: the single amd64 layer was
downloaded and its dpkg database read.

```console
$ curl -s -o layer.tgz -H "Authorization: Bearer $DTOKEN" \
    https://registry-1.docker.io/v2/library/debian/blobs/sha256:11422d7ca1a44390a32bd8d8d9dc5946b4d053b3bbd9507d682e35584ba84a26
$ tar xzf layer.tgz -C root && grep -c '^Package:' root/var/lib/dpkg/status
88
$ grep -E '^Package: (libssl3|libsnappy1v5|liblz4-1|libstdc\+\+6|libgcc-s1|libtinfo6|zlib1g|libzstd1|libbz2-1.0|ca-certificates|curl|openssl)$' root/var/lib/dpkg/status
Package: libbz2-1.0
Package: libc6
Package: libgcc-s1
Package: liblz4-1
Package: libstdc++6
Package: libtinfo6
Package: libzstd1
Package: zlib1g
$ ls root/usr/bin | grep -E '^(curl|wget|busybox|openssl)$'   # (no output)
```

| needed soname                        | package        | in `bookworm-slim`?         |
| ------------------------------------ | -------------- | --------------------------- |
| `libc.so.6` + `ld-linux-x86-64.so.2` | `libc6`        | yes                         |
| `libm.so.6`                          | `libc6`        | yes                         |
| `libgcc_s.so.1`                      | `libgcc-s1`    | yes                         |
| `libstdc++.so.6`                     | `libstdc++6`   | yes (`libstdc++.so.6.0.30`) |
| `libtinfo.so.6`                      | `libtinfo6`    | yes (`libtinfo.so.6.4`)     |
| `liblz4.so.1`                        | `liblz4-1`     | yes (`liblz4.so.1.9.4`)     |
| `libcrypto.so.3`                     | `libssl3`      | **no — install**            |
| `libsnappy.so.1`                     | `libsnappy1v5` | **no — install**            |

Only **two** packages are genuinely missing. `ca-certificates` is a third,
separate question: it is not a shared-library dependency, but
`EbbServer.Sync.AuthPlug` (`ebb_server/lib/ebb_server/sync/auth_plug.ex:102`)
does `Req.post/2` to an auth service over HTTPS, and OTP's
`:public_key.cacerts_get/0` reads the OS trust store on Linux — without
`ca-certificates` outbound TLS verification fails. `config/prod.exs` at the
commit this note was written against (`13651ef`) sets `auth_mode: :bypass`, so it
is only exercised once real auth is enabled.

## 4. Elixir release semantics

### 4.1 ERTS is bundled

`ebb_server/mix.exs` has no `releases:` key, so the documented defaults apply:
"`:include_erts` — … If a boolean, it indicates whether the Erlang Runtime
System (ERTS) … should be included in the release. **The default is `true`**,
which is also the recommended value." (`elixir` v1.17.3,
`lib/mix/lib/mix/tasks/release.ex:426`). The built release confirms it:

```console
$ ls ebb_server/_build/prod/rel/ebb_server
bin  erts-15.0  lib  releases
$ cat ebb_server/_build/prod/rel/ebb_server/releases/start_erl.data
15.0 0.1.0
$ ls ebb_server/_build/prod/rel/ebb_server/erts-15.0/bin | head -3
beam.smp  ct_run  dialyzer
```

So the runtime image needs **no** Erlang/Elixir installed.

### 4.2 `config/runtime.exs`: boot time, not build time

Official docs:

- `Mix.Tasks.Release` (v1.17.3, `release.ex:637-653`): "To enable runtime
  configuration in your release, all you need to do is to create a file named
  `config/runtime.exs` … This file will be executed whenever your Mix project or
  your release starts. … If a `config/runtime.exs` exists, it will be copied to
  your release and executed early in the boot process, when only Elixir and
  Erlang's main applications have been started."
- `Config` (v1.17.3, `lib/elixir/lib/config.ex:89-93`): "For runtime
  configuration, you can use the `config/runtime.exs` file. It is executed right
  before applications start in both Mix and releases (assembled with `mix release`)."
  Same module, line 260: runtime config "does not support imports, as they are
  meant to be copied across systems."
- Build-time is `config/config.exs` only: "Whenever you invoke a `mix` command,
  Mix loads the configuration in `config/config.exs` … We say that this
  configuration is a build-time configuration as it is evaluated whenever you
  compile your code or whenever we assemble the release." (`release.ex:617-620`)

Experiment (throwaway project, `/tmp/reltest`, never in this repo). `config/runtime.exs`
appends a line to a marker file; build, then boot:

```console
$ MIX_ENV=prod mix release --overwrite | grep runtime
* using config/runtime.exs to configure the release at runtime
$ cat /tmp/reltest_marker.log
cat: /tmp/reltest_marker.log: No such file or directory      # <- NOT evaluated at build
$ ls _build/prod/rel/reltest/releases/0.1.0/runtime.exs
_build/prod/rel/reltest/releases/0.1.0/runtime.exs            # <- copied into the release
$ _build/prod/rel/reltest/bin/reltest eval 'IO.puts("flag=" <> inspect(Application.get_env(:reltest, :flag)))'
flag={:from_runtime_exs, "reltest"}
$ cat /tmp/reltest_marker.log
runtime.exs pid=3097910 mix_env= release=reltest              # MIX_ENV empty, RELEASE_NAME set => boot
```

**Answer: boot time only.** Nothing from `runtime.exs` is baked in at build time,
so `docker run -e …` works. Corollary for image builds: the build stage cannot
rely on runtime env vars, and every `mix` command _does_ load
`config/config.exs` + `config/<env>.exs`.

Current repo state: **there is no `ebb_server/config/runtime.exs`** (`ls
ebb_server/config` → `config.exs dev.exs prod.exs test.exs`), and the release has
no `releases/0.1.0/runtime.exs` and no `RUNTIME_CONFIG=true` in
`releases/0.1.0/sys.config`. Container config is read at boot by
`Application.start/2` instead: `EBB_PORT` (`application.ex:158`) and
`EBB_DATA_DIR` (`application.ex:61`). That is equivalent for Docker purposes. If a
`runtime.exs` is ever added, note that `bin/ebb_server` then writes
`$RELEASE_TMP/<name>-<vsn>-<ts>-<rand>.runtime` before boot
(`bin/ebb_server:83-95`), so the release tree (or `RELEASE_TMP`) must be
writable by the container user.

### 4.3 A raising `start/2` exits non-zero, but says almost nothing

`start` is a foreground `exec` of the bundled ERTS (good for containers: the
shell is replaced, so the BEAM is PID 1 and receives signals):

```console
$ sed -n '69,82p' ebb_server/_build/prod/rel/ebb_server/bin/ebb_server
start () {
  export_release_sys_config
  REL_EXEC="$1"
  shift
  exec "$REL_VSN_DIR/$REL_EXEC" \
       --cookie "$RELEASE_COOKIE" \
       $(release_distribution "$RELEASE_NODE") \
       --erl "-mode $RELEASE_MODE" \
       --erl-config "$RELEASE_SYS_CONFIG" \
       --boot "$REL_VSN_DIR/$RELEASE_BOOT_SCRIPT" ...
$ sed -n '/^  start)$/,+2p' ebb_server/_build/prod/rel/ebb_server/bin/ebb_server
  start)
    start "elixir" --no-halt
    ;;
```

Experiment: `Reltest.Application.start/2` raises.

```console
$ timeout 60 _build/prod/rel/reltest/bin/reltest start; echo "EXIT CODE: $?"
{exit,terminating,[{application_controller,call,2,[{file,"application_controller.erl"},{line,511}]},
 {application,enqueue_or_start,6,...},{application,ensure_all_started,3,...},
 {elixir,start_cli,0,...},{init,start_it,1,[]},{init,start_em,1,[]},{init,do_boot,3,[]}]}
Runtime terminating during boot (terminating)

Crash dump is being written to: erl_crash.dump...done
EXIT CODE: 1
```

**Answer: it exits 1 immediately (no hang), but the raised message is not
printed.** Grepping the dump is the only way to recover it —
`grep -n 'Elixir.RuntimeError\|boom' erl_crash.dump` finds
`Module: 'Elixir.RuntimeError'` and the stack, and the exception text is not on
stdout/stderr. Practical consequence for a Docker HEALTHCHECK: a boot-unhealthy
container exits, and a running-but-not-ready one answers `503` from
`GET /healthz` (`ebb_server/lib/ebb_server/sync/router.ex:80`), so a healthcheck
pointed at `/healthz` distinguishes both; do not expect `docker logs` to explain
a boot crash.

Graceful shutdown was also verified with the same throwaway release:
`kill -TERM <start pid>` → `[notice] SIGTERM received - shutting down`, exit
code `0`. `bin/<app> daemon` is **not** usable in a container: it returns
immediately (`daemon EXIT: 0`) while the VM stays detached, so the container
would stop.

## 5. Healthcheck tooling

What `debian:bookworm-slim` actually contains (from the extracted layer, 88
packages): `bash` 5.2.15, `dash`, coreutils, `apt` — and **no** `curl`, `wget`,
`busybox`, or `openssl` binary (`/usr/bin` listing contains only `apt*`,
`bash`, `dash`, `gpgv` of the usual suspects).

`bash`'s `/dev/tcp` works in this image. Verified by running the layer's own bash
under the layer's own loader (the host is Ubuntu 24.04, so the bookworm binary
was executed with bookworm's `ld-linux`/`libc`):

```console
$ root/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 --library-path root/usr/lib/x86_64-linux-gnu \
    root/usr/bin/bash -c 'echo "$BASH_VERSION"; exec 3<>/dev/tcp/1.1.1.1/80 && echo "dev/tcp: OK" \
    && printf "GET / HTTP/1.0\r\n\r\n" >&3 && head -c 20 <&3'
5.2.15(1)-release
dev/tcp: OK
HTTP/1.1 403 Forbidden
```

So a zero-package healthcheck is possible, but it must spell out `bash` (the
default `HEALTHCHECK CMD` runs `sh -c`, and `dash` has no `/dev/tcp`) and it must
parse the status line itself:

```dockerfile
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD ["/bin/bash","-c","exec 3<>/dev/tcp/127.0.0.1/${EBB_PORT:-4000} && printf 'GET /healthz HTTP/1.0\\r\\n\\r\\n' >&3 && head -1 <&3 | grep -q ' 200 '"]
```

That is cheap but fragile (no HTTP framing, one shell builtin, no TLS). `curl`
is the pragmatic choice — and it also carries `libcurl4` → `libssl3`, which the
release needs anyway, so part of its cost is already mandatory.

Approximate **downloaded** sizes, from the Debian 12 archive
`dists/bookworm/main/binary-amd64/Packages.xz` (authoritative `Size:` field;
`apt-get install` of an already-present package downloads 0):

```console
$ curl -s -o Packages.xz https://deb.debian.org/debian/dists/bookworm/main/binary-amd64/Packages.xz
$ ls -l Packages.xz
8790396
# then a throwaway dependency closure over that index: parse Package/Version/Size/
# Installed-Size/Depends/Provides, resolve each `Depends:` alternative, and drop any
# package present in the extracted debian:bookworm-slim dpkg database.
#   roots = ca-certificates curl libsnappy1v5 liblz4-1 libssl3 libstdc++6
#   ->    pkgs=19  download=5.59 MiB  installed=14.1 MiB
#   roots = libsnappy1v5 libssl3
#   ->    pkgs= 2  download=1.97 MiB
#   roots = curl ca-certificates
#   ->    pkgs=18  download=5.57 MiB
```

Breakdown of the requested line (only the non-slim packages are listed):

| package                                                                                                                                        | download            |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `libssl3` 3.0.20-1~deb12u2                                                                                                                     | 1988 KiB            |
| `openssl` 3.0.20-1~deb12u2 (pulled by `ca-certificates`)                                                                                       | 1405 KiB            |
| `libcurl4` 7.88.1-10+deb12u15                                                                                                                  | 383 KiB             |
| `libkrb5-3`                                                                                                                                    | 325 KiB             |
| `curl` 7.88.1-10+deb12u15                                                                                                                      | 308 KiB             |
| `libbrotli1`                                                                                                                                   | 269 KiB             |
| `libldap-2.5-0`                                                                                                                                | 179 KiB             |
| `libssh2-1`                                                                                                                                    | 175 KiB             |
| `ca-certificates` 20230311+deb12u1                                                                                                             | 152 KiB             |
| `libgssapi-krb5-2`                                                                                                                             | 132 KiB             |
| `libk5crypto3`, `libnghttp2-14`, `librtmp1`, `libsasl2-2`, `libpsl5`, `libkrb5support0`, `libsnappy1v5`, `libsasl2-modules-db`, `libkeyutils1` | 410 KiB total       |
| `liblz4-1`, `libstdc++6`, `libgcc-s1`, `libtinfo6`                                                                                             | 0 (already in slim) |

Also budget `apt-get update` index metadata, compressed amd64: `main` 8.4 MiB +
`bookworm-updates` 0.01 MiB + `bookworm-security` 0.34 MiB ≈ **8.8 MiB** per
`apt-get update` run — larger than the packages themselves, so combine the
install into one `RUN` and delete `/var/lib/apt/lists/*`.

## 6. Risks found

1. **The release in `_build/prod/rel` cannot run on `debian:bookworm-slim`.**
   It was built on this Ubuntu 24.04 host (glibc 2.39), and its binaries require
   `GLIBC_2.38`:
   ```console
   $ objdump -T erts-15.0/bin/beam.smp | grep -o 'GLIBC_2\.38' | sort -u
   GLIBC_2.38
   $ objdump -T erts-15.0/bin/beam.smp | grep GLIBC_2.38 | awk '{print $NF}' | sort -u
   __isoc23_fscanf __isoc23_sscanf __isoc23_strtol __isoc23_vfscanf fmod
   $ objdump -T lib/rocksdb-2.5.0/priv/liberocksdb.so | grep -o 'GLIBC_2\.38'
   GLIBC_2.38
   ```
   bookworm ships glibc **2.36**, so `beam.smp` and `liberocksdb.so` would fail
   to load. The release must be **assembled inside the builder image** (`mix
deps.get && MIX_ENV=prod mix release` under `elixir:1.17.3-otp-27`), which is
   what the existing `ebb_server/Dockerfile` does — do not "optimise" it into a
   `COPY _build/prod/rel` from the host. The build host also runs ERTS 15.0
   (`.tool-versions` `erlang 27.0`) vs the image's 15.2.7.14.
   Same class of hazard for any future `COPY` of a locally built artifact, and
   for NIFs: rebuild them in the builder, then re-run the §3 `readelf` check in CI
   (a builder with `libzstd-dev`/`libbz2-dev` present could start linking those
   dynamically instead of statically).
2. **`ebb_server/Dockerfile` is a single stage `FROM elixir:1.17-otp-27`** (tag
   unpinned, so it silently follows `1.17.x`/OTP 27 patch bumps) and its
   `CMD ["_build/release/rel/ebb_server/bin/ebb_server", "start"]` points at a
   path `mix release` never produces — `MIX_ENV` is unset (→ `_build/dev/rel`),
   and even in prod it is `_build/prod/rel`. `RUN mix compile`/`mix release` also
   run without `MIX_ENV=prod`, and `prod.exs` (`auth_mode: :bypass`,
   `logger level: :warning`) would never be applied. Out of scope to fix here,
   but #566 has to.
3. **`releases/0.1.0/sys.config` has no `RUNTIME_CONFIG=true`** today because the
   repo has no `config/runtime.exs`. If one is added later, `bin/ebb_server`
   writes a generated sys.config into `$RELEASE_TMP` (default `$RELEASE_ROOT/tmp`)
   on every boot, so a read-only release tree or a non-writable root would break
   startup. Either set `RELEASE_TMP` to a writable path or keep using
   `Application.get_env`/`System.get_env` as the repo does now.
4. **Boot failures are opaque** (§4.3): only `erl_crash.dump` in the CWD carries
   the exception. In a container that file lands wherever the process was
   started (`WORKDIR`), is 2.4 MB, and is invisible from `docker logs`. Point
   `ERL_CRASH_DUMP` somewhere mounted if crash forensics matter.
5. **`libsnappy1v5` is a hard runtime dependency via `liberocksdb.so`.** It is
   absent from `bookworm-slim`; if it is missing the release boots and then dies
   the first time `liberocksdb` is loaded (`{:error, {:load_failed, ...}}`), i.e.
   self-hosting fails at `/healthz`, not at startup. Track it next to
   `libssl3` in the runtime stage, and note `scripts/setup-ebb-server.sh`
   installs the `-dev` packages for **build** only — it is not a runtime list.
6. **`ca-certificates` is not optional in the long run.** `AuthPlug` posts to an
   auth service over HTTPS; the `auth_mode: :bypass` default at `13651ef` hides
   the gap for now, but a self-hosted container with real auth would fail TLS
   verification without it (and OTP reads the OS trust store, so `castore` is not
   a substitute).
