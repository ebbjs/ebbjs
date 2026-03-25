The Batch API provides full support of the `WriteBatch`  API from rocksdb and allows you to maintain a batch resource that can  be atomically comitted to the database.



## basic operations

```
{ok, Batch} = rocksdb:batch(),

ok = rocksdb:batch_put(Batch, <<"a">>, <<"v1">>),
ok = rocksdb:batch_put(Batch, <<"b">>, <<"v2">>),
ok = rocksdb:batch_delete(Batch, <<"b">>),
?assertEqual(3, rocksdb:batch_count(Batch)),

?assertEqual(not_found, rocksdb:get(Db, <<"a">>, [])),
?assertEqual(not_found, rocksdb:get(Db, <<"b">>, [])),

ok = rocksdb:write_batch(Db, Batch, []),

?assertEqual({ok, <<"v1">>}, rocksdb:get(Db, <<"a">>, [])),
?assertEqual(not_found, rocksdb:get(Db, <<"b">>, [])),

ok = rocksdb:release_batch(Batch),
```

## rollback

```
{ok, Batch} = rocksdb:batch(),
ok = rocksdb:batch_put(Batch, <<"a">>, <<"v1">>),
ok = rocksdb:batch_put(Batch, <<"b">>, <<"v2">>),
ok = rocksdb:batch_savepoint(Batch),
ok = rocksdb:batch_put(Batch, <<"c">>, <<"v3">>),
?assertEqual(3, rocksdb:batch_count(Batch)),
?assertEqual([{put, <<"a">>, <<"v1">>},
            {put, <<"b">>, <<"v2">>},
            {put, <<"c">>, <<"v3">>}], rocksdb:batch_tolist(Batch)),
ok = rocksdb:batch_rollback(Batch),
?assertEqual(2, rocksdb:batch_count(Batch)),
?assertEqual([{put, <<"a">>, <<"v1">>},
            {put, <<"b">>, <<"v2">>}], rocksdb:batch_tolist(Batch)),
ok = rocksdb:close_batch(Batch)
```

This api allows you to rollback the records inside a batch from the last checkpont