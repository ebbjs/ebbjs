#!/usr/bin/env node
/**
 * Write-then-read-back probe used by the container smoke test.
 *
 * The container has no Elixir toolchain and the CI job that runs it has
 * no built TypeScript packages, so this probe hand-encodes the one
 * MessagePack Action the seed shape needs instead of importing
 * `@ebbjs/core`. It proves the persistence acceptance criterion end to
 * end: `write` before the container is destroyed, `verify` against a new
 * container reusing the same volume.
 *
 * Usage:
 *   node scripts/docker-persistence-check.mjs write  http://localhost:4000
 *   node scripts/docker-persistence-check.mjs verify http://localhost:4000
 */

import { setTimeout as sleep } from "node:timers/promises";

const ACTOR_ID = "actor_docker_smoke";
const GROUP_ID = "grp_docker_smoke";
const MEMBER_ID = "gm_docker_smoke";
const ENTITY_GROUP_ID = "eg_docker_smoke";
const ENTITY_ID = "ent_docker_smoke";
const ENTITY_TYPE = "todo";
const FIELD_VALUE = "Docker persistence smoke";

// ── MessagePack encoding ────────────────────────────────────────────

const encode = (value) => {
  if (value === null || value === undefined) return Buffer.from([0xc0]);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length < 32) return Buffer.concat([Buffer.from([0xa0 | bytes.length]), bytes]);
    if (bytes.length < 256) return Buffer.concat([Buffer.from([0xd9, bytes.length]), bytes]);
    const head = Buffer.alloc(3);
    head[0] = 0xda;
    head.writeUInt16BE(bytes.length, 1);
    return Buffer.concat([head, bytes]);
  }
  if (typeof value === "number" || typeof value === "bigint") {
    const n = BigInt(value);
    if (n >= 0n && n < 128n) return Buffer.from([Number(n)]);
    if (n >= 128n && n < 256n) return Buffer.from([0xcc, Number(n)]);
    if (n >= 256n && n < 65536n) {
      const head = Buffer.alloc(3);
      head[0] = 0xcd;
      head.writeUInt16BE(Number(n), 1);
      return head;
    }
    if (n >= 65536n && n < 4294967296n) {
      const head = Buffer.alloc(5);
      head[0] = 0xce;
      head.writeUInt32BE(Number(n), 1);
      return head;
    }
    if (n >= 0n) {
      const head = Buffer.alloc(9);
      head[0] = 0xcf;
      head.writeBigUInt64BE(n, 1);
      return head;
    }
    throw new Error(`negative integers are not used by the seed shape: ${n}`);
  }
  if (Array.isArray(value)) {
    if (value.length > 15) throw new Error("seed arrays stay under 16 entries");
    return Buffer.concat([Buffer.from([0x90 | value.length]), ...value.map(encode)]);
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > 15) throw new Error("seed maps stay under 16 entries");
    return Buffer.concat([
      Buffer.from([0x80 | entries.length]),
      ...entries.flatMap(([key, val]) => [encode(key), encode(val)]),
    ]);
  }
  throw new Error(`cannot encode ${typeof value}`);
};

// ── Seed shape ──────────────────────────────────────────────────────

const stamp = (value, hlc) => ({ value, update_id: "seed_update", hlc });

const update = (id, subjectId, subjectType, fields) => ({
  id,
  subject_id: subjectId,
  subject_type: subjectType,
  method: "put",
  data: { fields },
});

/** The bootstrap Action `@ebbjs/core`'s seed builder emits, by hand. */
const buildSeedAction = (hlc) => ({
  id: `act_docker_smoke_${hlc}`,
  actor_id: ACTOR_ID,
  hlc,
  updates: [
    update("u_group", GROUP_ID, "group", { name: stamp("Docker Smoke", hlc) }),
    update("u_member", MEMBER_ID, "groupMember", {
      actor_id: stamp(ACTOR_ID, hlc),
      group_id: stamp(GROUP_ID, hlc),
      // Permission strings are `<entity_type>.<verb>`; the wildcard
      // covers the verbs this probe reads back.
      permissions: stamp(["todo.*"], hlc),
    }),
    update("u_entity", ENTITY_ID, ENTITY_TYPE, { title: stamp(FIELD_VALUE, hlc) }),
    update("u_entity_group", ENTITY_GROUP_ID, "entityGroup", {
      entity_id: stamp(ENTITY_ID, hlc),
      group_id: stamp(GROUP_ID, hlc),
    }),
  ],
});

// ── HTTP ────────────────────────────────────────────────────────────

const headers = { "x-ebb-actor-id": ACTOR_ID };

const retry = async (label, fn, attempts = 30) => {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastError?.message}`);
};

const write = async (baseUrl) => {
  // Logical time must sit inside the server's future-drift window, so the
  // HLC is stamped from this host's clock rather than a constant.
  const action = buildSeedAction(BigInt(Date.now()) << 16n);

  const res = await retry("write", async () => {
    const response = await fetch(`${baseUrl}/sync/actions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/msgpack" },
      body: encode({ actions: [action] }),
    });
    if (!response.ok) {
      throw new Error(`POST /sync/actions returned ${response.status} ${await response.text()}`);
    }
    return response;
  });

  const body = await res.json();
  const rejected = body.rejected ?? [];
  if (rejected.length > 0) {
    throw new Error(`seed was rejected: ${JSON.stringify(rejected)}`);
  }
  console.log(`write: seeded ${ENTITY_ID} as ${ACTOR_ID}`);
};

const verify = async (baseUrl) => {
  const body = await retry("verify", async () => {
    const response = await fetch(`${baseUrl}/entities/${ENTITY_ID}`, { headers });
    if (!response.ok) {
      throw new Error(`GET /entities/${ENTITY_ID} returned ${response.status}`);
    }
    return response.json();
  });

  const value = body?.data?.fields?.title?.value;
  if (value !== FIELD_VALUE) {
    throw new Error(`expected title ${JSON.stringify(FIELD_VALUE)}, got ${JSON.stringify(value)}`);
  }
  if (!(body.last_gsn > 0)) {
    throw new Error(`expected a committed GSN, got ${JSON.stringify(body.last_gsn)}`);
  }
  console.log(`verify: ${ENTITY_ID} survived with title ${JSON.stringify(value)}`);
};

// ── Entry point ─────────────────────────────────────────────────────

const [command, url = "http://localhost:4000"] = process.argv.slice(2);
const baseUrl = url.replace(/\/$/, "");

const commands = { write, verify };

if (!commands[command]) {
  console.error(`usage: ${process.argv[1]} <write|verify> [url]`);
  process.exit(2);
}

try {
  await commands[command](baseUrl);
} catch (error) {
  console.error(`${command}: ${error.message}`);
  process.exit(1);
}
