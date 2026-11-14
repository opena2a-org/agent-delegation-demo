// A process started inside the offline check's block that ends its parent,
// the rerun's root process, after the scenarios ran and before the rerun
// answers.
process.kill(process.ppid, 'SIGKILL');
