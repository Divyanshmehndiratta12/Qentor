import '@testing-library/jest-dom/vitest'

// jsdom has no layout engine, so it doesn't implement the geometry methods
// CodeMirror's QASM editor calls when it measures itself on a frame after
// mount (Range#getClientRects / getBoundingClientRect). Without these, any
// test that keeps the Lab mounted long enough logs a `getClientRects is not a
// function` TypeError to stderr. Stubs only fill the gap when jsdom lacks the
// method, and return "no boxes" — no test asserts anything about layout, and
// nothing here touches quantum data or application behaviour.
if (typeof Range !== 'undefined') {
  const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList
  const emptyRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) }) as DOMRect

  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = emptyRects
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = emptyRect
}
