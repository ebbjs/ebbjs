Actions - durable
Signals - ephemeral

Works of WS instead of SSE, bidirectional, subscribe to a "room" that is keyed off of any entity id. Permission to listen is based on membership to related group.

Can use it as a primitive for presence data or for arbitrary binary (i.e. share cursor position but also audio/video?).

Propogations can happen between servers where a server can listen to the room stream of another server and propogate that to it's listeners of that same room. Works the other way too.
