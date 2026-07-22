function prefix(args) {
  return ['[pix]', ...args];
}

function log(...args) {
  console.error(...prefix(args));
}

function warn(...args) {
  console.error(...prefix(args));
}

function fatal(...args) {
  console.error(...prefix(args));
  process.exit(1);
}

module.exports = { log, warn, fatal };
