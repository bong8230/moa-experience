'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Only the HTML shell is public. Application source, configuration and runtime files stay private.
fs.mkdirSync(path.join(__dirname, '..', 'public'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', 'preview', 'index.html'), path.join(__dirname, '..', 'public', 'index.html'));
