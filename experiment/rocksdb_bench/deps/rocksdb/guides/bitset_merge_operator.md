The bitset operator allows you to maintain a bitmap. You can set or unset a bit at a oisutuib in a fixed bitmap. 

Ex:

```erlang

 {ok, Db} = rocksdb:open("/tmp/rocksdb_merge_db.test",
                        [{create_if_missing, true},
                         {merge_operator, {bitset_merge_operator, 1024}}]),

Bitmap = << 0:1024/unsigned >>,
ok = rocksdb:put(Db, <<"bitmap">>, Bitmap, []),
ok = rocksdb:merge(Db, <<"bitmap">>, <<"+2">>, []),
{ok, << 32, _/binary>> } = rocksdb:get(Db, <<"bitmap">>, []),
ok = rocksdb:merge(Db, <<"bitmap">>, <<"-2">>, []),
{ok, << 0, _/binary>> } = rocksdb:get(Db, <<"bitmap">>, []),
ok = rocksdb:merge(Db, <<"bitmap">>, <<"+11">>, []),
{ok, << 0, 16, _/binary>> } = rocksdb:get(Db, <<"bitmap">>, []),
ok = rocksdb:merge(Db, <<"bitmap">>, <<"+10">>, []),
{ok, << 0, 48, _/binary>> } = rocksdb:get(Db, <<"bitmap">>, []),

ok = rocksdb:merge(Db, <<"unsetbitmap">>, <<"+2">>, []),
{ok, << 32, _/binary>> } = rocksdb:get(Db, <<"unsetbitmap">>, []),
ok = rocksdb:merge(Db, <<"unsetbitmap">>, <<"-2">>, []),
{ok, << 0, _/binary>> } = rocksdb:get(Db, <<"unsetbitmap">>, []),
ok = rocksdb:merge(Db, <<"unsetbitmap">>, <<"+11">>, []),
{ok, << 0, 16, _/binary>> } = rocksdb:get(Db, <<"unsetbitmap">>, []),
ok = rocksdb:merge(Db, <<"unsetbitmap">>, <<"+10">>, []),
{ok, << 0, 48, _/binary>> } = rocksdb:get(Db, <<"unsetbitmap">>, []),

ok = rocksdb:close(Db),
```