const electron = require('electron');
console.log('Keys in electron module:', Object.keys(electron));
console.log('Has app?', !!electron.app);
if (!electron.app) {
    console.log('App is undefined. Process type:', process.type);
}
process.exit(0);
