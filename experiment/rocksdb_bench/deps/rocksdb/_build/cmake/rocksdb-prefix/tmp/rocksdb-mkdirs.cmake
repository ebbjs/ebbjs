# Distributed under the OSI-approved BSD 3-Clause License.  See accompanying
# file LICENSE.rst or https://cmake.org/licensing for details.

cmake_minimum_required(VERSION ${CMAKE_VERSION}) # this file comes with cmake

# If CMAKE_DISABLE_SOURCE_CHANGES is set to true and the source directory is an
# existing directory in our source tree, calling file(MAKE_DIRECTORY) on it
# would cause a fatal error, even though it would be a no-op.
if(NOT EXISTS "/Users/drew.lyton/Projects/loaf/experiment/rocksdb_bench/deps/rocksdb/deps/rocksdb")
  file(MAKE_DIRECTORY "/Users/drew.lyton/Projects/loaf/experiment/rocksdb_bench/deps/rocksdb/deps/rocksdb")
endif()
file(MAKE_DIRECTORY
  "/Users/drew.lyton/Projects/loaf/experiment/rocksdb_bench/deps/rocksdb/_build/cmake/rocksdb-prefix/src/rocksdb-build"
  "/Users/drew.lyton/Projects/loaf/experiment/rocksdb_bench/deps/rocksdb/_build/cmake/rocksdb-prefix"
  "/Users/drew.lyton/Projects/loaf/experiment/rocksdb_bench/deps/rocksdb/_build/cmake/rocksdb-prefix/tmp"
  "/Users/drew.lyton/Projects/loaf/experiment/rocksdb_bench/deps/rocksdb/_build/cmake/rocksdb-prefix/src/rocksdb-stamp"
  "/Users/drew.lyton/Projects/loaf/experiment/rocksdb_bench/deps/rocksdb/_build/cmake/rocksdb-prefix/src"
  "/Users/drew.lyton/Projects/loaf/experiment/rocksdb_bench/deps/rocksdb/_build/cmake/rocksdb-prefix/src/rocksdb-stamp"
)

set(configSubDirs )
foreach(subDir IN LISTS configSubDirs)
    file(MAKE_DIRECTORY "/Users/drew.lyton/Projects/loaf/experiment/rocksdb_bench/deps/rocksdb/_build/cmake/rocksdb-prefix/src/rocksdb-stamp/${subDir}")
endforeach()
if(cfgdir)
  file(MAKE_DIRECTORY "/Users/drew.lyton/Projects/loaf/experiment/rocksdb_bench/deps/rocksdb/_build/cmake/rocksdb-prefix/src/rocksdb-stamp${cfgdir}") # cfgdir has leading slash
endif()
