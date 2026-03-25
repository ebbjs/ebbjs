# Distributed under the OSI-approved BSD 3-Clause License.  See accompanying
# file LICENSE.rst or https://cmake.org/licensing for details.

cmake_minimum_required(VERSION ${CMAKE_VERSION}) # this file comes with cmake

# If CMAKE_DISABLE_SOURCE_CHANGES is set to true and the source directory is an
# existing directory in our source tree, calling file(MAKE_DIRECTORY) on it
# would cause a fatal error, even though it would be a no-op.
if(NOT EXISTS "/Users/drew.lyton/Projects/loaf/experiment/rocksdb_bench/deps/rocksdb/c_src/../deps/CRoaring")
  file(MAKE_DIRECTORY "/Users/drew.lyton/Projects/loaf/experiment/rocksdb_bench/deps/rocksdb/c_src/../deps/CRoaring")
endif()
file(MAKE_DIRECTORY
  "/Users/drew.lyton/Projects/loaf/experiment/rocksdb_bench/deps/rocksdb/_build/cmake/croaring"
  "/Users/drew.lyton/Projects/loaf/experiment/rocksdb_bench/deps/rocksdb/_build/cmake/croaring-prefix"
  "/Users/drew.lyton/Projects/loaf/experiment/rocksdb_bench/deps/rocksdb/_build/cmake/croaring-prefix/tmp"
  "/Users/drew.lyton/Projects/loaf/experiment/rocksdb_bench/deps/rocksdb/_build/cmake/croaring-prefix/src/croaring-stamp"
  "/Users/drew.lyton/Projects/loaf/experiment/rocksdb_bench/deps/rocksdb/_build/cmake/croaring-prefix/src"
  "/Users/drew.lyton/Projects/loaf/experiment/rocksdb_bench/deps/rocksdb/_build/cmake/croaring-prefix/src/croaring-stamp"
)

set(configSubDirs )
foreach(subDir IN LISTS configSubDirs)
    file(MAKE_DIRECTORY "/Users/drew.lyton/Projects/loaf/experiment/rocksdb_bench/deps/rocksdb/_build/cmake/croaring-prefix/src/croaring-stamp/${subDir}")
endforeach()
if(cfgdir)
  file(MAKE_DIRECTORY "/Users/drew.lyton/Projects/loaf/experiment/rocksdb_bench/deps/rocksdb/_build/cmake/croaring-prefix/src/croaring-stamp${cfgdir}") # cfgdir has leading slash
endif()
