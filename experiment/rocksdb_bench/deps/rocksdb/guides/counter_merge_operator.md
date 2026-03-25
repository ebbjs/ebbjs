The counter operator allows you to maintain a counter. You can increase or decrease the counter with an integer value 

Ex:

```erlang

{ok, Db} = rocksdb:open("/tmp/rocksdb_merge_db.test",
                        [{create_if_missing, true},
                         {merge_operator, counter_merge_operator}]),

ok = rocksdb:merge(Db, <<"c">>, << "1" >>, []),
{ok, << "1" >>} = rocksdb:get(Db, <<"c">>, []),

ok = rocksdb:merge(Db, <<"c">>, << "2" >>, []),
{ok, << "3" >>} = rocksdb:get(Db, <<"c">>, []),

ok = rocksdb:merge(Db, <<"c">>, <<"-1">> , []),
{ok, <<"2">>} = rocksdb:get(Db, <<"c">>, []),

ok = rocksdb:put(Db, <<"c">>, <<"0">>, []),
{ok, <<"0">>} = rocksdb:get(Db, <<"c">>, []),


ok = rocksdb:close(Db),
```