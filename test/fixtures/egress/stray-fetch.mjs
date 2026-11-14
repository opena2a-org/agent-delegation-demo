// A process started inside the offline check's block, as a grant path
// process would be, that makes one stray request to a documentation address
// (192.0.2.1). Port 80, because fetch refuses port 9 before any socket call.
try {
  await fetch('http://192.0.2.1:80/');
} catch {
  // Refused by the block.
}
