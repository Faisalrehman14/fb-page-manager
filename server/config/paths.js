const path = require('path');

const ROOT = path.join(__dirname, '../..');
const PUBLIC = path.join(ROOT, 'public');
const UPLOADS = path.join(ROOT, 'uploads');
const SERVER = path.join(ROOT, 'server');

function publicPath(...segments) {
    return path.join(PUBLIC, ...segments);
}

module.exports = {
    ROOT,
    PUBLIC,
    UPLOADS,
    SERVER,
    publicPath
};
