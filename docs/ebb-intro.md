# Way Too Ambitious

Hey friend,

My favorite way to avoid writing is to dream about my perfect notes app.

Not just a place to store thoughts — something that works offline, syncs across devices, lets me share a document with a collaborator and leave comments in real-time. Obsidian's file-based, offline-first experience, but with the collaboration features of a modern app.

So I started building it. Seemed simple enough — add some sync on top of SQLite, hook up a library for collaborative text editing, call it a day. What could go wrong?

Everything. Everything could go wrong.

Turns out "sync" is a four-letter word. What happens when two people edit the same note offline? Who decides which change wins? How do you even agree on what "first" means when no one is talking to a server? And then there's schema evolution — what do you do when you ship a breaking change to a database that lives on thousands of devices?

Conflict resolution, server-assigned ordering, garbage collection, permissions — each problem opened a door to three more. I kept building anyway. I hadn't shipped a single feature for the notes app. I had built a distributed systems textbook.

At some point I realized: this has to be easier.

I started researching what others had built — a dozen libraries, frameworks, databases — and kept hitting the same wall: great primitives, but still a lot of glue code. Everyone was solving one piece of the puzzle. I just wanted something that worked.

So I started building it myself. First version taught me what *not* to do. Second taught me what could work. Third taught me what actually *did* work. **ebb** is the fourth — a complete rewrite with everything I've learned.

ebb is a local-first backend framework. It gives developers the primitives they actually need: offline writes, automatic sync, conflict resolution — without requiring a PhD in distributed systems to use them.

I've already posted the first devlog, and there's a lot more to come. Expect deep dives on local-first architecture, the trade-offs of distributed systems, building with Elixir, and what it takes to create an open-source database framework from scratch.

Until next time,

Drew
