// Playwright's evaluate context cannot itself import an asynchronous ESM graph.
// Import through an ordinary Node module; the existing app module is reused.
module.exports = file => import(require('node:url').pathToFileURL(file).href);
