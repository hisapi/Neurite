/* Loads Neurite's classic scripts into this Node context, as a browser would,
 * for the DOM-free math modules. Returns a getter for their globals. */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');

module.exports = function load(...files) {
    for (const file of files) {
        vm.runInThisContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file });
    }
    return (name)=>vm.runInThisContext(name);
};
