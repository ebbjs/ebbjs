---
title: "Getting Started"
description: "Set up ebb in your project in under five minutes."
---

Ebb is a sync engine that makes the network optional. This guide will get you up and running quickly.

## Installation

```bash
npm install @ebbjs/core @ebbjs/client
```

## Define a schema

First, define your models using `defineModel` with Ebb's typed field builders:

```ts
import { defineModel, defineSchema, e } from "@ebbjs/core";

const todo = defineModel("todo", {
  title: e.string(),
  completed: e.boolean(),
});
```

Each field declares its type and merge strategy. `e.string()` and `e.boolean()` are [LWW fields](/docs/data-model#typed-fields)—concurrent updates to the same field resolve via last-write-wins. Other field types like `e.counter()` and `e.collaborativeText()` use CRDT merge strategies. See the [data model](/docs/data-model#typed-fields) for the full list of field types.

Then wrap your models in a schema with `defineSchema`:

```ts
const schema = defineSchema({
  todo,
});
```

## Create a client

```ts
import { createClient } from "@ebbjs/client";

const client = createClient({
  serverUrl: "http://localhost:3000",
  schema,
  fetch: {
    headers: {
      Authorization: `Bearer ${getToken()}`,
    },
  },
});
```

## Read and write data

```ts
// Create
const todo = await client.todo.create(
  { title: "Ship it", completed: false },
  { groupIds: ["my-group"] },
);

// Update
await client.todo.update(todo.id, { completed: true });

// Query
const incomplete = await client.todo
  .find()
  .eq("completed", false)
  .orderBy("createdAt", "desc")
  .limit(10);
```

Changes made offline will sync automatically when the connection is established.

## Use with React

```bash
npm install @ebbjs/react
```

```tsx
import { EbbProvider, useQuery, useConnection, useClient } from "@ebbjs/react";

function App() {
  return (
    <EbbProvider client={client}>
      <TodoList />
    </EbbProvider>
  );
}

function TodoList() {
  const client = useClient<typeof schema>();
  const { data: todos, isLoading } = useQuery(
    client.todo.find().eq("completed", false)
  );
  const connection = useConnection(); // "connected" | "connecting" | "disconnected"

  if (isLoading) return <p>Loading...</p>;

  return (
    <ul>
      {todos?.map((t) => (
        <li key={t.id}>{t.title}</li>
      ))}
    </ul>
  );
}
```

## Set up the server

```bash
npm install @ebbjs/server
```

```ts
import { createServer } from "@ebbjs/server";

const server = createServer({
  schema,
  authenticate: (req) => {
    const token = req.headers.get("Authorization")?.replace("Bearer ", "");
    return verifyToken(token);
  },
});
```

## Next Steps

- Read the [Ebb Overview](/docs/overview) to understand ebb's design philosophy
- Explore the [data model](/docs/data-model) and [sync protocol](/docs/sync) in depth
