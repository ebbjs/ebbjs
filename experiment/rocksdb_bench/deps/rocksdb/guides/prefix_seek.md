When the option `prefix_extractor` is set  for your DB or column family is specified, RocksDB is in a "prefix seek" mode, explained below. Example of how to use it:

```erlang
Options = [{create_if_missing, true}, {prefix_extractor, {fixed_prefix_transform, 3}}]),

{ok, Db} = rocksdb:open("/tmp/erocksdb", Options),

...
Itr = rocksdb:iterator(Db, []),
rocksdb:iterator_move(Itr, {seek, <<"foobar">>}), %% seek inside the prefix "foo"
rocksdb:iterator_move(Itr, next), %% Find next key-value pair inside prefix "foo"
```

For now we support to prefix extractor:

* `{fixed_prefix_transform, N}`: for fixed prefix size, where N is the size of the prefix
* `{capped_prefix_extractor, N}`: for a prefix with a maximum length of N 

See the [rocksdb documentation](https://github.com/facebook/rocksdb/wiki/Prefix-Seek-API-Changes) for more informations about this feature.