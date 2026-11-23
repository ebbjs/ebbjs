/**
 * Serialized-size accounting for the replica's diagnostics.
 *
 * The figures are UTF-8 bytes of JSON, not V8 heap: they are stable across
 * engines and runs, and one category can be compared with another. A heap
 * account belongs to the harness that can force GC; this cannot see it.
 */

/**
 * UTF-8 bytes of `text`, without depending on `Buffer` or `TextEncoder` so the
 * same count holds in Node, a browser, and React Native.
 *
 * A lone surrogate encodes as the three bytes of U+FFFD, as `TextEncoder`
 * does; a valid pair is one four-byte code point.
 */
export const utf8Bytes = (text: string): number => {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
};

/** UTF-8 bytes of `value`'s JSON. `undefined` is an empty value, so zero bytes. */
export const jsonBytes = (value: unknown): number => {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : utf8Bytes(text);
};
