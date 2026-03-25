From the rocksdb documentation:

Checkpoint is a feature in RocksDB which provides the ability to take a snapshot of a running RocksDB database in a separate directory. Checkpoints can be used as a point in time snapshot, which can be opened Read-only to query rows as of the point in time or as a Writeable snapshot by opening it Read-Write. Checkpoints can be used for both full and incremental backups.

The Checkpoint feature enables RocksDB to create a consistent snapshot of a given RocksDB database in the specified directory. If the snapshot is on the same filesystem as the original database, the SST files will be hard-linked, otherwise SST files will be copied. The manifest and CURRENT files will be copied. In addition, if there are multiple column families, log files will be copied for the period covering the start and end of the checkpoint, in order to provide a consistent snapshot across column families.

A Checkpoint object needs to be created for a database before checkpoints are created. The Erlang API is as follows:

```erlang
rocksdb:checkpoint(DbHandle::db_handle(), Path::file:filename_all()) -> ok | {error, any()}.
```

This function will creates a consistent snapshot of the database in the given directory.

The directory should not already exist and will be created by this API. The directory will be an absolute path. The checkpoint can be used as a ​read-only copy of the DB or can be opened as a standalone DB. When opened read/write, the SST files continue to be hard links and these links are removed when the files are obsoleted. When the user is done with the snapshot, the user can delete the directory to remove the snapshot.