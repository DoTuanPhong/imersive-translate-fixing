const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'megaplay_patch.user.js');
const text = fs.readFileSync(filePath, 'utf8');

const queries = ['dataUri', 'track', 'injected'];
for (const query of queries) {
    let idx = 0;
    while (true) {
        idx = text.indexOf(query, idx);
        if (idx === -1) break;
        const start = Math.max(0, idx - 100);
        const end = Math.min(text.length, idx + query.length + 300);
        console.log(`Match for "${query}" at ${idx}:`);
        console.log(text.substring(start, end));
        console.log('--------------------------------------------------');
        idx += query.length;
    }
}
