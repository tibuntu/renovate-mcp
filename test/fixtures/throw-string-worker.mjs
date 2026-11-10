// Test fixture: a worker that throws a non-Error value, so the parent's
// 'error' event carries a bare string. Used to cover the String(err) arm of
// resolveConfig's preview-fallback warning. See test/unit/presetResolver.test.ts.
throw "boom";
