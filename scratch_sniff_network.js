const puppeteer = require('puppeteer');

(async () => {
    console.log('Launching browser...');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    // Enable console log capture
    page.on('console', msg => {
        console.log(`[PAGE LOG] ${msg.type().toUpperCase()}: ${msg.text()}`);
    });

    // Intercept and monitor network requests
    page.on('request', request => {
        const url = request.url();
        if (url.includes('.vtt') || url.includes('sub') || url.includes('lostproject') || url.includes('subtitle')) {
            console.log(`[NETWORK REQ] ${request.method()} ${url}`);
        }
    });

    page.on('response', response => {
        const url = response.url();
        if (url.includes('.vtt') || url.includes('sub') || url.includes('lostproject') || url.includes('subtitle')) {
            console.log(`[NETWORK RESP] Status ${response.status()} for ${url}`);
        }
    });

    const url = 'https://anisuge.tv/watch/easygoing-territory-defense-by-the-optimistic-lord-production-magic-turns-a-nameless-village-into-the-strongest-fortified-city-v7zwi/ep-4';
    console.log(`Navigating to ${url}...`);
    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        console.log('Page loaded. Waiting 10 seconds for player/iframe to initialize and load subtitles...');
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        // Let's get the iframes on the page
        const frames = page.frames();
        console.log(`Found ${frames.length} frames on the page.`);
        for (const frame of frames) {
            console.log(`Frame: name=${frame.name()}, url=${frame.url()}`);
        }
    } catch (e) {
        console.error('Error during navigation:', e.message);
    }

    console.log('Closing browser...');
    await browser.close();
})();
