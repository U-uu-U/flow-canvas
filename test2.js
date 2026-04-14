const electron = require('electron');
console.log('Running in Electron');
console.log('Keys:', Object.keys(electron));
console.log('Is app present?', !!electron.app);
console.log('Is this packaged?', electron.app ? electron.app.isPackaged : 'N/A');
electron.app.quit();
