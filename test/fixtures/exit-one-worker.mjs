// Test fixture: a merge worker that exits non-zero before posting any message
// or throwing (so neither the 'message' nor 'error' event fires). Used to verify
// runMerge rejects promptly on an unexpected worker exit instead of hanging
// until the timeout. See test/unit/mergeWorker.test.ts.
process.exit(1);
