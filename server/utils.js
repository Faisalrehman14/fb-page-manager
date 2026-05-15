const fs = require('fs');
const path = require('path');

function logError(label, err) {
    const msg = `[${new Date().toISOString()}] [${label}] ${err.stack || err}\n`;
    console.error(msg);
    try {
        fs.appendFileSync(path.join(__dirname, 'error.log'), msg);
    } catch (e) {}
}

module.exports = {
    logError
};
