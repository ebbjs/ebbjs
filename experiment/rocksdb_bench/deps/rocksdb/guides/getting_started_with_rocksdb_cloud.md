The [rocksdb-cloud](https://gitlab.com/barrel-db/erlang-rocksdb/tree/rocksdb-cloud) branch brings the support of  **[RocksDB-Cloud](https://github.com/rockset/rocksdb-cloud)** from rockset to Erlang Applications.

> Note: in addition to the features of [RocksDB-Cloud](https://github.com/rockset/rocksdb-cloud), support of custom S3 implementations like minio has been added.

## RocksDB-Cloud

[RocksDB-Cloud](https://github.com/rockset/rocksdb-cloud) is a C++ library that brings the power of RocksDB to AWS, Google Cloud and Microsoft Azure. It leverages the power of RocksDB to provide fast key-value access to data stored in Flash and RAM systems. It provides for data durability even in the face of machine failures by integrations with cloud services like AWS-S3 and Google Cloud Services. It allows a cost-effective way to utilize the rich hierarchy of storage services (based on RAM, NvMe, SSD, Disk Cold Storage, etc) that are offered by most cloud providers. RocksDB-Cloud is developed and maintained by the engineering team at Rockset Inc. Start with https://github.com/rockset/rocksdb-cloud/tree/master/cloud.

RocksDB-Cloud provides three main advantages for AWS environments:

* A rocksdb instance is durable. Continuous and automatic replication of db data and metadata to S3. In the event that the rocksdb machine dies, another process on any other EC2 machine can reopen the same rocksdb database (by configuring it with the S3 bucketname where the entire db state was stored).
* A rocksdb instance is cloneable. RocksDB-Cloud support a primitive called zero-copy-clone() that allows a slave instance of rocksdb on another machine to clone an existing db. Both master and slave rocksdb instance can run in parallel and they share some set of common database files.
* A rocksdb instance can leverage hierarchical storage. The entire rocksdb storage footprint need not be resident on local storage. S3 contains the entire database and the local storage contains only the files that are in the working set.

## Build

### Build dependencies

To build `rocksdb-cloud` you need to have [aws-sdk-cpp](https://github.com/aws/aws-sdk-cpp) installed in standard location (`/usr/local`) with s3 and kinosis components:

```shell
wget https://github.com/aws/aws-sdk-cpp/archive/1.7.80.tar.gz -O aws-sdk.tar.gz 
tar xvzf -O aws-sdk.tar.gz 
cd aws-sdk-cpp-1.7.80
cmake -DBUILD_ONLY="s3;kinesis" . 
make -j4 all && sudo make install 
```

Then install `librdkafka`:

```shell
LIBRDKAFKA_VERSION=1.0.0
wget https://github.com/edenhill/librdkafka/archive/v${LIBRDKAFKA_VERSION}.tar.gz
tar -zxvf v${LIBRDKAFKA_VERSION}.tar.gz
sudo bash -c "cd librdkafka-${LIBRDKAFKA_VERSION} && ./configure && make && make install"
```

> in macosx install them using `homebrew` : 

```shell
brew install aws-sdk-cpp librdkafka
```

### Build the binding

Add the binding to your  `rebar.config`

```erlang
{deps, [
  {rocksdb, 
    {git, "https://gitlab.com/barrel-db/erlang-rocksdb.git", 
      {branch, "rocksdb-cloud"}}}
]}
```

or to your mix config file:

```elixir
{: rocksdb, git: "https://gitlab.com/barrel-db/erlang-rocksdb.git", branch: "rocksdb-cloud"}
```



## Usage

### Initialize a cloud environnement

```erlang
Credentials = [{access_key_id, "admin"},
                 {secret_key, "password"}],
AwsOptions =  [{endpoint_override, "127.0.0.1:9000"}, {scheme, "http"}],
EnvOptions = [{credentials, Credentials}, {aws_options, AwsOptions}],
{ok, CloudEnv} = rocksdb:new_cloud_env("test", "", "", "test", "", "", EnvOptions).
```

See other [options from the documentation](https://gitlab.com/barrel-db/erlang-rocksdb/blob/rocksdb-cloud/doc/rocksdb.md#new_cloud_env-7).

### Open a database

```erlang
DbOptions =  [{create_if_missing, true}, {env, CloudEnv}],
PersistentCachePath =  "/tmp/test",
PersistentCacheSize = 128 bsl 20, %% 128 MB.
{ok, Db} = rocksdb:open_cloud_db("cloud_db", DbOptions, PersistentCachePath, PersistentCacheSize).
```

When you create a cloud database using [rocksdb:open_cloud_db/{4,5,6}](https://gitlab.com/barrel-db/erlang-rocksdb/blob/rocksdb-cloud/doc/rocksdb.md#open_cloud_db-4) you pass to the database options the environment created above and set the size of the persistent cache and its size in bytes.

Then you can use the database like any databases:

```erlang
ok = rocksdb:put(Db, <<"key">>, <<"value">>, []),
{ok, <<"value">>} = rocksdb:get(Db, <<"key">>, []),
```

Makes sure to close the database when flushing it.