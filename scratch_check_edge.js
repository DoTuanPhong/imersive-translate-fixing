const http = require('http');

http.get('http://127.0.0.1:9222/json', (res) => {
    let data = '';
    res.on('data', (chunk) => {
        data += chunk;
    });
    res.on('end', () => {
        try {
            const targets = JSON.parse(data);
            console.log('Successfully connected to Edge on port 9222!');
            console.log(`Found ${targets.length} targets:`);
            targets.forEach((target, i) => {
                console.log(`[${i}] ${target.title}`);
                console.log(`    URL: ${target.url}`);
                console.log(`    Type: ${target.type}`);
                console.log(`    WebSocket URL: ${target.webSocketDebuggerUrl}`);
            });
        } catch (e) {
            console.error('Error parsing JSON from Edge:', e.message);
            console.log('Raw data was:', data);
        }
    });
}).on('error', (err) => {
    console.error('Could not connect to Edge on port 9222. Is it running with --remote-debugging-port=9222?');
    console.error('Error details:', err.message);
});
