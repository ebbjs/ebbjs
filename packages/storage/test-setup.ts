/**
 * Vitest setup: installs a fake-indexeddb implementation on globalThis
 * before any test runs. The IndexedDB adapter depends on this for
 * in-process tests; real browsers ship the API natively.
 */
import "fake-indexeddb/auto";
