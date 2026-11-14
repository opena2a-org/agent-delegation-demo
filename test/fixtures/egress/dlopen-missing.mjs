// A process started inside the offline check's block that asks to load a
// native module from a path that does not exist.
try {
  process.dlopen({ exports: {} }, '/nonexistent/bank-demo-missing.node');
} catch {
  // No such file.
}
